# StatusStorage


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**mode** | **str** |  |
**source** | **str** |  |
**database_name** | **str** |  | [optional]
**database_path** | **str** |  | [optional]

## Example

```python
from openapi_client.models.status_storage import StatusStorage

# TODO update the JSON string below
json = "{}"
# create an instance of StatusStorage from a JSON string
status_storage_instance = StatusStorage.from_json(json)
# print the JSON string representation of the object
print(StatusStorage.to_json())

# convert the object into a dict
status_storage_dict = status_storage_instance.to_dict()
# create an instance of StatusStorage from a dict
status_storage_from_dict = StatusStorage.from_dict(status_storage_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)

# GetStatus200ResponseStorage


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**mode** | **str** |  |
**source** | **str** |  |
**database_name** | **str** |  | [optional]
**database_path** | **str** |  | [optional]

## Example

```python
from openapi_client.models.get_status200_response_storage import GetStatus200ResponseStorage

# TODO update the JSON string below
json = "{}"
# create an instance of GetStatus200ResponseStorage from a JSON string
get_status200_response_storage_instance = GetStatus200ResponseStorage.from_json(json)
# print the JSON string representation of the object
print(GetStatus200ResponseStorage.to_json())

# convert the object into a dict
get_status200_response_storage_dict = get_status200_response_storage_instance.to_dict()
# create an instance of GetStatus200ResponseStorage from a dict
get_status200_response_storage_from_dict = GetStatus200ResponseStorage.from_dict(get_status200_response_storage_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)

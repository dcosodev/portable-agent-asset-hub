# GetStatusDefaultResponseError


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**code** | **str** |  | 
**message** | **str** |  | 
**status** | **int** |  | 

## Example

```python
from openapi_client.models.get_status_default_response_error import GetStatusDefaultResponseError

# TODO update the JSON string below
json = "{}"
# create an instance of GetStatusDefaultResponseError from a JSON string
get_status_default_response_error_instance = GetStatusDefaultResponseError.from_json(json)
# print the JSON string representation of the object
print(GetStatusDefaultResponseError.to_json())

# convert the object into a dict
get_status_default_response_error_dict = get_status_default_response_error_instance.to_dict()
# create an instance of GetStatusDefaultResponseError from a dict
get_status_default_response_error_from_dict = GetStatusDefaultResponseError.from_dict(get_status_default_response_error_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)



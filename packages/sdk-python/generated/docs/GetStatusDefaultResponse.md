# GetStatusDefaultResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**error** | [**GetStatusDefaultResponseError**](GetStatusDefaultResponseError.md) |  | 
**request_id** | **str** |  | 

## Example

```python
from openapi_client.models.get_status_default_response import GetStatusDefaultResponse

# TODO update the JSON string below
json = "{}"
# create an instance of GetStatusDefaultResponse from a JSON string
get_status_default_response_instance = GetStatusDefaultResponse.from_json(json)
# print the JSON string representation of the object
print(GetStatusDefaultResponse.to_json())

# convert the object into a dict
get_status_default_response_dict = get_status_default_response_instance.to_dict()
# create an instance of GetStatusDefaultResponse from a dict
get_status_default_response_from_dict = GetStatusDefaultResponse.from_dict(get_status_default_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


